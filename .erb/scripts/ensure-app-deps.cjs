/**
 * beforePack hook for electron-builder.
 *
 * release/app is its own pnpm workspace (see release/app/pnpm-workspace.yaml).
 * electron-builder collects the packaged dependency tree with `pnpm list` in
 * that directory. A parent-workspace install never records an importer for
 * release/app, so that list is empty and runtime modules are dropped.
 *
 * This script installs production dependencies with the committed
 * release/app/pnpm-lock.yaml, then removes type-only packages that should not
 * ship. The registry comes from the workspace root .npmrc so local and CI
 * installs resolve the same registry.
 */
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const { verifyInstalledRuntimeDeps } = require('./runtime-deps.cjs')

exports.default = async function ensureAppDeps(context) {
  const appDir = path.join(__dirname, '..', '..', 'release', 'app')
  const projectDir = path.join(appDir, '..', '..')
  const nodeModulesDir = path.join(appDir, 'node_modules')

  // Replace any node_modules left by a parent-workspace hoist or a previous npm ci.
  if (fs.existsSync(nodeModulesDir)) {
    fs.rmSync(nodeModulesDir, { recursive: true, force: true })
  }

  console.log('[ensure-app-deps] Installing production dependencies in release/app/ ...')
  execSync('pnpm install --prod --ignore-scripts --frozen-lockfile --config.engine-strict=false', {
    cwd: appDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_registry: getProjectRegistry(projectDir),
      COREPACK_ENABLE_STRICT: '0',
    },
  })

  verifyInstalledRuntimeDeps(appDir)
  verifyVersionsMatchPnpmWorkspace(appDir)

  // Remove type-only packages that are not needed at runtime.
  // @anthropic-ai/sandbox-runtime incorrectly lists @types/lodash-es
  // in production dependencies, pulling in @types/* and undici-types.
  const packagesToRemove = ['@types', 'undici-types']
  for (const pkg of packagesToRemove) {
    const pkgPath = path.join(nodeModulesDir, pkg)
    if (fs.existsSync(pkgPath)) {
      fs.rmSync(pkgPath, { recursive: true, force: true })
      console.log(`[ensure-app-deps] Removed dev-only package: ${pkg}`)
    }
  }

  console.log('[ensure-app-deps] Done.')
}

function readProjectNpmrc(projectDir) {
  return fs.readFileSync(path.join(projectDir, '.npmrc'), 'utf8')
}

function getProjectRegistry(projectDir, options = {}) {
  const readNpmrc = options.readNpmrc || readProjectNpmrc
  let registry = ''
  for (const line of readNpmrc(projectDir).split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator >= 0 && line.slice(0, separator).trim() === 'registry') {
      registry = line.slice(separator + 1).trim()
    }
  }
  if (!registry) {
    throw new Error('[ensure-app-deps] workspace .npmrc must configure a default registry')
  }
  return registry
}

/**
 * Guard against version skew between release/app/package-lock.json (used by
 * `npm ci` to materialize node_modules) and the root pnpm-lock.yaml (used by
 * electron-builder's pnpm node-module collector).
 *
 * electron-builder detects this repo as a pnpm workspace and resolves the
 * packaged dependency tree via `pnpm list`, while the physical node_modules is
 * created by npm. If the two lockfiles resolve a package to different versions,
 * the collector cannot find the expected version on disk and silently drops the
 * package from the asar — e.g. ws@8.20.0 on disk vs ws@8.19.0 expected caused
 * `Cannot find module 'ws'` at app startup. Keep the versions aligned (e.g.
 * via "overrides" in release/app/package.json); this check makes any future
 * skew fail the build loudly instead of shipping a broken app.
 *
 * `--lockfile-only` reads release/app/pnpm-lock.yaml (this directory is its own
 * workspace) instead of node_modules, so the comparison stays stable after the
 * production install.
 *
 * Type-only packages (@types/*, undici-types) are excluded: they are removed
 * from disk before packaging and never needed at runtime.
 */
function readPnpmProductionDependencyTree(appDir) {
  return execSync(
    'pnpm list --prod --json --depth Infinity --silent --loglevel=error --lockfile-only',
    {
      cwd: appDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, COREPACK_ENABLE_STRICT: '0' },
    },
  ).toString()
}

function verifyVersionsMatchPnpmWorkspace(appDir, options = {}) {
  const readPnpmList = options.readPnpmList || readPnpmProductionDependencyTree
  let pnpmList
  try {
    const output = readPnpmList(appDir)
    pnpmList = JSON.parse(output)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `[ensure-app-deps] failed to verify versions against pnpm workspace lockfile: ${message}`,
    )
  }

  const pnpmVersions = new Map()
  const walk = (node) => {
    for (const [depName, dep] of Object.entries(node?.dependencies || {})) {
      if (dep && dep.version) {
        pnpmVersions.set(depName, dep.version)
      }
      walk(dep)
    }
  }
  walk(Array.isArray(pnpmList) ? pnpmList[0] : pnpmList)

  if (pnpmVersions.size === 0) {
    // Fail closed: an empty tree means the check saw nothing to compare, which
    // would silently report every skew as verified. Better to fail the build
    // than to ship a package with missing runtime dependencies again.
    throw new Error(
      '[ensure-app-deps] pnpm list returned no production dependencies — cannot verify version alignment with the pnpm workspace lockfile. ' +
        'Run `pnpm list --prod --json --lockfile-only` in release/app/ to debug.',
    )
  }

  const npmLock = JSON.parse(fs.readFileSync(path.join(appDir, 'package-lock.json'), 'utf8'))
  const mismatches = []
  for (const [name, pnpmVersion] of pnpmVersions) {
    if (name.startsWith('@types/') || name === 'undici-types') {
      continue
    }
    const npmKey = Object.keys(npmLock.packages).find((key) => {
      return key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`)
    })
    const npmVersion = npmKey != null ? npmLock.packages[npmKey].version : undefined
    if (npmVersion !== pnpmVersion) {
      mismatches.push(`  ${name}: npm lock ${npmVersion ?? '(missing)'} != pnpm lock ${pnpmVersion}`)
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `[ensure-app-deps] version skew between release/app/package-lock.json and the pnpm workspace lockfile:\n${mismatches.join('\n')}\n` +
        'Align the versions (e.g. via "overrides" in release/app/package.json), otherwise the packaged app will silently miss runtime dependencies.',
    )
  }

  console.log('[ensure-app-deps] verified dependency versions match pnpm workspace lockfile')
}

exports.verifyVersionsMatchPnpmWorkspace = verifyVersionsMatchPnpmWorkspace
exports.getProjectRegistry = getProjectRegistry

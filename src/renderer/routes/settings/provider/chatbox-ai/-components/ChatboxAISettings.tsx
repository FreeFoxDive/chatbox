import { Button, PasswordInput, Stack, Text, TextInput, Transition } from '@mantine/core'
import { isOfficialChatboxServer, normalizeChatboxServerOrigin } from '@shared/free-edition'
import { type ModelProvider, ModelProviderEnum } from '@shared/types'
import { ANONYMOUS_WORKSPACE, customWorkspaceNamespace } from '@shared/workspace-namespace'
import { useTranslation } from 'react-i18next'
import { enterWorkspace, getActiveWorkspaceNamespace } from '@/stores/workspaceIdentity'
import { useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import useChatboxAIModels from '@/hooks/useChatboxAIModels'
import { useLanguage, useProviderSettings, useSettingsStore } from '@/stores/settingsStore'
import { VIEW_TRANSITION_DURATION, VIEW_TRANSITION_TIMING } from './constants'
import { LicenseKeyView } from './LicenseKeyView'
import { LicenseSelectionModal } from './LicenseSelectionModal'
import { LoggedInView } from './LoggedInView'
import { LoginView } from './LoginView'
import { ModelManagement } from './ModelManagement'
import type { ViewMode } from './types'
import { useAuthTokens } from './useAuthTokens'

function CustomChatboxServerPanel({ apiHost, apiKey }: { apiHost?: string; apiKey?: string }) {
  const { t } = useTranslation()
  const [host, setHost] = useState(apiHost || '')
  const [accessKey, setAccessKey] = useState(apiKey || '')
  const [error, setError] = useState('')

  const save = async () => {
    const origin = normalizeChatboxServerOrigin(host)
    if (!origin || isOfficialChatboxServer(origin)) {
      setError(t('Enter a custom Chatbox server URL') || 'Enter a custom Chatbox server URL')
      return
    }
    setError('')
    const namespace = await customWorkspaceNamespace(origin, accessKey.trim())
    await enterWorkspace(namespace, {
      providers: {
        [ModelProviderEnum.ChatboxAI]: {
          apiHost: origin,
          apiKey: accessKey.trim() || undefined,
        },
      },
    })
  }

  return (
    <Stack gap="sm">
      <TextInput
        label={t('Custom server URL') || 'Custom server URL'}
        description={t('Use your own Chatbox-compatible server without an official account.') || ''}
        placeholder="https://example.com"
        value={host}
        onChange={(event) => setHost(event.currentTarget.value)}
      />
      <PasswordInput
        label={t('Access key (optional)') || 'Access key (optional)'}
        value={accessKey}
        onChange={(event) => setAccessKey(event.currentTarget.value)}
      />
      {error ? (
        <Text size="sm" c="dimmed">
          {error}
        </Text>
      ) : null}
      <Button variant="default" onClick={() => void save()}>
        {t('Save custom server') || 'Save custom server'}
      </Button>
      {getActiveWorkspaceNamespace() !== ANONYMOUS_WORKSPACE ? (
        <Button variant="subtle" c="chatbox-tertiary" onClick={() => void enterWorkspace(ANONYMOUS_WORKSPACE)}>
          {t('Disconnect and return to this device') || 'Disconnect and return to this device'}
        </Button>
      ) : null}
    </Stack>
  )
}

export function ChatboxAISettings({ padded = false }: { padded?: boolean }) {
  const requestedView = useRouterState({
    select: (state) => {
      const view = (state.location.search as Record<string, unknown>).view
      return view === 'login' || view === 'licenseKey' ? view : undefined
    },
  })
  const language = useLanguage()
  const providerId: ModelProvider = ModelProviderEnum.ChatboxAI
  const { providerSettings, setProviderSettings } = useProviderSettings(providerId)

  const licenseActivationMethod = useSettingsStore((state) => state.licenseActivationMethod)

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (requestedView === 'login') return 'login'
    if (requestedView === 'licenseKey') return 'licenseKey'
    if (licenseActivationMethod === 'manual') {
      return 'licenseKey'
    }
    if (licenseActivationMethod === 'login') {
      return 'login'
    }
    return 'login'
  })

  useEffect(() => {
    if (requestedView === 'login') setViewMode('login')
    if (requestedView === 'licenseKey') setViewMode('licenseKey')
  }, [requestedView])

  const { isLoggedIn, clearAuthTokens, saveAuthTokens, afterLogin, consumeLogin } = useAuthTokens()
  const licenseKey = useSettingsStore((state) => state.licenseKey)

  const { allChatboxAIModels, chatboxAIModels, refetch: refetchChatboxAIModels } = useChatboxAIModels()

  const deleteModel = (modelId: string) => {
    setProviderSettings({
      excludedModels: [...(providerSettings?.excludedModels || []), modelId],
    })
  }

  const resetModels = () => {
    setProviderSettings({
      models: [],
      excludedModels: [],
    })
  }

  const [licenseModalState, setLicenseModalState] = useState<{
    show: boolean
    licenses: any[]
    onConfirm?: (licenseKey: string) => void
    onCancel?: () => void
  }>({
    show: false,
    licenses: [],
  })

  const showLicenseSelectionModal = useCallback(
    (params: { licenses: any[]; onConfirm: (licenseKey: string) => void; onCancel: () => void }) => {
      setLicenseModalState({
        show: true,
        ...params,
      })
    },
    []
  )

  const handleLicenseModalConfirm = (licenseKey: string) => {
    licenseModalState.onConfirm?.(licenseKey)
    setLicenseModalState({ show: false, licenses: [] })
  }

  const handleLicenseModalCancel = () => {
    licenseModalState.onCancel?.()
    setLicenseModalState({ show: false, licenses: [] })
  }

  // Dynamic height management for view transitions
  const containerRef = useRef<HTMLDivElement>(null)
  const loginViewRef = useRef<HTMLDivElement>(null)
  const licenseKeyViewRef = useRef<HTMLDivElement>(null)
  const [containerHeight, setContainerHeight] = useState<number>(0)

  useLayoutEffect(() => {
    const targetRef = viewMode === 'login' ? loginViewRef : licenseKeyViewRef

    let resizeObserver: ResizeObserver | null = null
    let mutationObserver: MutationObserver | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const updateHeight = () => {
      if (targetRef.current) {
        setContainerHeight(targetRef.current.scrollHeight)
      }
    }

    const setupObservers = () => {
      const targetElement = targetRef.current
      if (!targetElement) return

      resizeObserver = new ResizeObserver(updateHeight)
      resizeObserver.observe(targetElement)

      mutationObserver = new MutationObserver(updateHeight)
      mutationObserver.observe(targetElement, {
        childList: true,
        subtree: true,
        attributes: true,
      })
    }

    if (!targetRef.current) {
      // Element not ready yet, wait and then setup observers
      timer = setTimeout(() => {
        updateHeight()
        setupObservers()
      }, 50)
    } else {
      updateHeight()
      setupObservers()
    }

    return () => {
      if (timer) clearTimeout(timer)
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
    }
  }, [viewMode, isLoggedIn, licenseKey])

  return (
    <Stack gap="xxl" p={padded ? 'md' : undefined}>
      {/* License Selection Modal */}
      <CustomChatboxServerPanel apiHost={providerSettings?.apiHost} apiKey={providerSettings?.apiKey} />

      <LicenseSelectionModal
        opened={licenseModalState.show}
        licenses={licenseModalState.licenses}
        onConfirm={handleLicenseModalConfirm}
        onCancel={handleLicenseModalCancel}
      />

      {/* View Transition Container */}
      <div
        ref={containerRef}
        style={{
          position: 'relative',
          height: containerHeight,
          transition: `height ${VIEW_TRANSITION_DURATION}ms ${VIEW_TRANSITION_TIMING}`,
          overflow: 'hidden',
        }}
      >
        <Transition
          mounted={viewMode === 'login'}
          transition="slide-right"
          duration={VIEW_TRANSITION_DURATION}
          timingFunction={VIEW_TRANSITION_TIMING}
        >
          {(styles) => (
            <div style={{ ...styles, position: 'absolute', top: 0, left: 0, right: 0 }}>
              {isLoggedIn ? (
                <LoggedInView
                  afterLogin={afterLogin}
                  onLoginSelectionHandled={consumeLogin}
                  ref={loginViewRef}
                  onLogout={clearAuthTokens}
                  language={language}
                  onShowLicenseSelectionModal={showLicenseSelectionModal}
                  onSwitchToLicenseKey={() => setViewMode('licenseKey')}
                />
              ) : (
                <LoginView
                  ref={loginViewRef}
                  language={language}
                  saveAuthTokens={saveAuthTokens}
                  onSwitchToLicenseKey={() => setViewMode('licenseKey')}
                />
              )}
            </div>
          )}
        </Transition>

        <Transition
          mounted={viewMode === 'licenseKey'}
          transition="slide-left"
          duration={VIEW_TRANSITION_DURATION}
          timingFunction={VIEW_TRANSITION_TIMING}
        >
          {(styles) => (
            <div style={{ ...styles, position: 'absolute', top: 0, left: 0, right: 0 }}>
              <LicenseKeyView
                ref={licenseKeyViewRef}
                language={language}
                onSwitchToLogin={() => setViewMode('login')}
              />
            </div>
          )}
        </Transition>
      </div>

      <ModelManagement
        chatboxAIModels={chatboxAIModels}
        allChatboxAIModels={allChatboxAIModels}
        onDeleteModel={deleteModel}
        onResetModels={resetModels}
        onFetchModels={refetchChatboxAIModels}
        onAddModel={(model) => {
          const models = providerSettings?.models || []
          setProviderSettings({
            models: models.some((item) => item.modelId === model.modelId) ? models : [...models, model],
            excludedModels: (providerSettings?.excludedModels || []).filter((m) => m !== model.modelId),
          })
        }}
        onRemoveModel={(modelId) =>
          setProviderSettings({
            excludedModels: [...(providerSettings?.excludedModels || []), modelId],
          })
        }
      />
    </Stack>
  )
}

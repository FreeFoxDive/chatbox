import type { CapacitorConfig } from '@capacitor/cli'
import { KeyboardResize } from '@capacitor/keyboard'

const config: CapacitorConfig = {
  appId: 'xyz.chatboxapp.free',
  appName: 'Chatbox Free',
  webDir: 'release/app/dist/renderer',
  server: {
    androidScheme: 'https',
    allowNavigation: ['*'],
  },
  android: {
    allowMixedContent: true,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: '#ffffff',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    Keyboard: {
      resize: KeyboardResize.Body,
      resizeOnFullScreen: true,
    },
  },
}

export default config

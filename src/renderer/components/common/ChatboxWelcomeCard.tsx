import { Button, Paper, Stack, Text } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import { navigateToSettings } from '@/modals/settings-navigation'
import type { HomeWelcomeCardMode } from '@/utils/homeWelcomeCard'

export function ChatboxWelcomeCard(props: { mode: HomeWelcomeCardMode; pageName: string; className?: string }) {
  const { mode, className } = props
  const { t } = useTranslation()

  if (mode === 'none') {
    return null
  }

  return (
    <Paper
      radius="lg"
      withBorder
      py="md"
      px="sm"
      className={`bg-white/40 dark:bg-zinc-900/40 backdrop-blur-md ${className || ''}`}
    >
      <Stack gap="sm" align="center">
        <Text fw={600} className="text-center">
          {t('Welcome to Chatbox!')}
        </Text>
        <Text size="xs" c="chatbox-tertiary" className="text-center">
          {t('Configure a model provider to start chatting.')}
        </Text>
        <Button size="xs" variant="filled" onClick={() => navigateToSettings('provider')}>
          {t('Configure model provider')}
        </Button>
      </Stack>
    </Paper>
  )
}

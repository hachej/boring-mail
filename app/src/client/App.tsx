import { WorkspaceAgentFront } from '@hachej/boring-workspace/app/front'
import { createAskUserPlugin } from '@hachej/boring-ask-user/front'
import { boringMailBoringUiPlugin } from '@hachej/boring-mail/front'
import './styles.css'

const askUserPlugin = createAskUserPlugin({ appLeftInbox: true })
const surfaceStorageKey = 'boring-mail:surface:v4'

function seedMailWorkbenchSourceOpen() {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(`${surfaceStorageKey}:leftState`, JSON.stringify({ mode: 'source', activeTab: 'boring-mail.source' }))
  window.localStorage.setItem(`${surfaceStorageKey}:sidebarWidth`, '280')
}

seedMailWorkbenchSourceOpen()

export function App() {
  return (
    <WorkspaceAgentFront
      workspaceId="default"
      agentTypeId="default"
      apiBaseUrl=""
      persistenceEnabled={false}
      providerStorageKey="boring-mail:layout:v4"
      surfaceStorageKey={surfaceStorageKey}
      sessionStorageKey="boring-mail:sessions:v4"
      appTitle="Boring Mail"
      workspaceLabel="Chief-of-Staff inbox"
      workspaceLayout="plugin-tabs"
      defaultSessionTitle="Chief of Staff"
      defaultWorkbenchLeftTab="boring-mail.source"
      defaultWorkbenchLeftOpen
      defaultSurfaceOpen
      showSkills={false}
      showPlugins={false}
      externalPlugins={false}
      frontPluginHotReload={false}
      plugins={[askUserPlugin, boringMailBoringUiPlugin]}
      chatParams={{
        emptyState: {
          eyebrow: 'Mail chief-of-staff',
          title: 'Agents read first. You stay in control.',
          description: 'Use the Mail source to inspect raw threads, draft .mail.md replies, and surface only the moments that need you.',
        },
        suggestions: [
          { label: 'Triage my unread mail', prompt: 'Search the mailbox for unread or important items and summarize what needs my attention.' },
          { label: 'Draft a concise reply', prompt: 'Create a .mail.md draft reply to the selected thread with a concise, professional tone.' },
          { label: 'Find bills and invoices', prompt: 'Search mail for bills, invoices, or payment-related messages and list the important ones.' },
          { label: 'Open my latest draft', prompt: 'List mail drafts and open the most recent .mail.md draft.' },
        ],
      }}
    />
  )
}

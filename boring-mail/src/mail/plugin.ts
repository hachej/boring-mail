import { defineMailPlugin } from '../plugin-host/definePlugin'
import { BORING_MAIL_PLUGIN_ID, BORING_MAIL_THREAD_SURFACE_KIND } from './shared/constants'
import { findMockMailThread } from './mockData'
import { MailSourcePane } from './client/MailSourcePane'
import { MailThreadPanel } from './client/MailThreadPanel'

export const mailPlugin = defineMailPlugin({
  id: BORING_MAIL_PLUGIN_ID,
  label: 'Mail',
  source: {
    id: 'boring-mail.source',
    label: 'Mail',
    component: MailSourcePane,
  },
  panels: [
    {
      id: 'boring-mail.thread',
      label: 'Email',
      component: MailThreadPanel,
    },
  ],
  surfaceResolvers: [
    {
      kind: BORING_MAIL_THREAD_SURFACE_KIND,
      resolve(target) {
        const thread = findMockMailThread(target)
        if (!thread) return undefined
        return {
          panelId: 'boring-mail.thread',
          instanceId: `boring-mail.thread.${thread.id}`,
          title: thread.subject,
          params: { threadId: thread.id },
        }
      },
    },
  ],
})

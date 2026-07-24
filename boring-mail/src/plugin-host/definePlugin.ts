import type { ComponentType } from 'react'
import type { MailThread } from '../shared/types'

export interface MailWorkspaceSourceProps {
  openThread(thread: MailThread): void
  openCompose(): void | Promise<void>
}

export interface MailPlugin {
  id: string
  label: string
  source: {
    id: string
    label: string
    component: ComponentType<MailWorkspaceSourceProps>
  }
  panels: Array<{
    id: string
    label: string
    component: ComponentType<any>
  }>
  surfaceResolvers: Array<{
    kind: string
    resolve(target: string): { panelId: string; instanceId: string; title: string; params: Record<string, unknown> } | undefined
  }>
}

export function defineMailPlugin(plugin: MailPlugin): MailPlugin {
  return plugin
}

export interface ErrorResponse {
  error: string
}

export interface MessageResponse {
  message: string
}

export interface VersionResponse {
  version: string
}

export interface AppSummary {
  name: string
  image: string
  domains: string[]
  hostPort?: number
  trackTag: string
  currentImage?: string
  port?: number
  deployedAt?: string
  status: 'running' | 'stopped' | 'no deployment'
  webhookUrl: string
  previews: PreviewSummary[]
}

export interface AppDetail {
  name: string
  image: string
  domains: string[]
  internalPort?: number
  trackTag: string
  imagePrefix?: string
  env: Record<string, string>
  currentImage?: string
  port?: number
  deployedAt?: string
  deployments: number
  webhookUrl: string
}

export interface RollbackResponse {
  success: boolean
  image: string
  port: number
  containerId: string
  error?: string
}

export interface RollbackTargetResponse {
  image: string
  deployedAt: string
}

export interface StopResponse {
  message: string
  containerId: string
}

export interface StartResponse {
  message: string
  port: number
}

export interface ContainerStats {
  cpu: number
  memory: number
  memoryLimit: number
  networkRx: number
  networkTx: number
}

export interface PreviewSummary {
  name: string
  label: string
  domain: string
  status: 'running' | 'stopped' | 'no deployment'
  image?: string
  deployedAt?: string
  expiresAt?: string
}

export interface DeploymentInfo {
  image: string
  digest?: string
  containerId: string
  port: number
  deployedAt: string
  isCurrent: boolean
}

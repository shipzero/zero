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
  domain?: string
  hostPort?: number
  trackTag: string
  currentImage?: string
  port?: number
  deployedAt?: string
  status: 'running' | 'stopped' | 'no deployment'
  webhookUrl: string
}

export interface AppDetail {
  name: string
  image: string
  domain?: string
  internalPort: number
  trackTag: string
  env: Record<string, string>
  currentImage?: string
  port?: number
  deployedAt?: string
  deployments: number
  webhookUrl: string
}

export interface AddAppResponse {
  name: string
  webhookSecret: string
  webhookUrl: string
}

export interface DeployResult {
  success: boolean
  image: string
  port: number
  containerId: string
  url?: string
  error?: string
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

export interface PreviewDeployResponse {
  name: string
  label: string
  domain: string
  url: string
  success: boolean
  error?: string
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
  containerId: string
  port: number
  deployedAt: string
  isCurrent: boolean
}

export interface HealthResponse {
  status: 'ok'
  service: 'interrogation-api'
  configuration: {
    ready: boolean
    missing: string[]
    invalid: string[]
  }
  message: string
}

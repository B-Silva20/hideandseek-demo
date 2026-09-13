import { Router } from 'express'
import { configurationMessage, getConfigurationStatus } from '../config.js'

export function createHealthRouter() {
  const router = Router()

  router.get('/health', (_request, response) => {
    const configuration = getConfigurationStatus()
    response.setHeader('Cache-Control', 'no-store')
    response.json({
      status: 'ok',
      service: 'interrogation-api',
      configuration,
      message: configurationMessage(configuration),
    })
  })

  return router
}

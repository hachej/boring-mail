import { parentPort, workerData } from 'node:worker_threads'

if (workerData?.failStartup) {
  parentPort.postMessage({
    type: 'ready',
    error: { name: 'ProductStoreError', code: 'invalid_input', message: 'fixture startup failed' },
  })
} else {
  parentPort.postMessage({ type: 'ready' })
  parentPort.on('message', (request) => {
    if (request.method === 'getDraft' && request.args[0] === 'crash') process.exit(0)
    if (request.method === 'getOutbox') {
      parentPort.postMessage({
        type: 'response', id: request.id,
        error: { name: 'ProductStoreError', code: 'not_found', message: 'fixture outbox missing' },
      })
      return
    }
    const values = {
      upsertAccount: undefined,
      getDraft: null,
      listAttention: [],
      claimNext: null,
      close: undefined,
    }
    parentPort.postMessage({ type: 'response', id: request.id, value: values[request.method] })
  })
}

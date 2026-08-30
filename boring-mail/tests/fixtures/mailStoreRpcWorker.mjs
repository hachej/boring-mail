import { parentPort, workerData } from 'node:worker_threads'

const send = (value, delay = 0) => setTimeout(() => parentPort.postMessage(value), delay)

if (workerData?.silentStartup) {
  // Intentionally no ready response; parent startup deadline must terminate us.
} else if (workerData?.failStartup) {
  send({
    type: 'ready',
    error: { name: 'ProductStoreError', code: 'invalid_input', message: 'fixture startup failed' },
  }, workerData?.startupDelayMs ?? 0)
} else {
  send({ type: 'ready' }, workerData?.startupDelayMs ?? 0)
  parentPort.on('message', (request) => {
    if (request.method === 'getDraft' && request.args[0] === 'crash') process.exit(0)
    if (request.method === 'getDraft' && request.args[0] === 'hang') return
    if (request.method === 'getOutbox') {
      send({
        type: 'response', id: request.id,
        error: { name: 'ProductStoreError', code: 'not_found', message: 'fixture outbox missing' },
      }, workerData?.responseDelayMs ?? 0)
      return
    }
    const values = {
      upsertAccount: undefined,
      getDraft: null,
      reconcileMsgvaultReadSources: { inserted: 0, updated: 0, vanished: 0, generation: 'fixture' },
      setReadSourceEnabled: undefined,
      listUnifiedInbox: { items: [], nextCursor: null },
      getUnifiedThread: null,
      listAttention: [],
      claimNext: null,
      close: undefined,
    }
    const delay = request.method === 'close'
      ? (workerData?.closeDelayMs ?? 0)
      : (workerData?.responseDelayMs ?? 0)
    send({ type: 'response', id: request.id, value: values[request.method] }, delay)
  })
}

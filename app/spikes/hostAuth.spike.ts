export {
  createStandaloneHostAuth as createHostAuthSpike,
  readBoundedTailscaleStatus,
  readVerifiedTokenFile,
  BORING_MAIL_BASIC_USERNAME,
  BORING_MAIL_PROXY_PRINCIPAL_HEADER,
  BORING_MAIL_PROXY_PROOF_HEADER,
  BORING_MAIL_READ_CAPABILITY,
  BORING_MAIL_WORKSPACE_ID,
} from '../src/server/standaloneHostAuth'
export type {
  StandaloneDeploymentConfig,
  StandaloneDeploymentMode,
  StandaloneHostAuthOptions as HostAuthSpikeOptions,
  ValidatedStandaloneHostAuth as ValidatedHostAuthSpike,
} from '../src/server/standaloneHostAuth'

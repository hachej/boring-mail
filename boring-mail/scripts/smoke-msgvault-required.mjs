#!/usr/bin/env node
process.env.BORING_MAIL_REQUIRE_MSGVAULT = '1'
await import('./smoke-msgvault-direct.mjs')

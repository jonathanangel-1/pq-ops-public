#!/usr/bin/env node
"use strict";

const {
  runHostDurabilityCommandCli,
} = require("../lib/pikiio-host-durability");

if (require.main === module) {
  process.exitCode = runHostDurabilityCommandCli();
}

module.exports = { runHostDurabilityCommandCli };

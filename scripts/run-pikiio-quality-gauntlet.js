#!/usr/bin/env node
"use strict";

const runner = require("../lib/pikiio-quality-runner");

runner.bootstrapQualityGauntlet({
  isMain: require.main === module,
  argv: process.argv,
});

module.exports = runner;

#!/usr/bin/env node
import { runDaemon } from './daemon';

runDaemon(process.argv.slice(2));

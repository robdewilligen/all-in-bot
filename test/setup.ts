import { logger } from '../src/core/logger.js';

// Tests that check logging spy on the logger instead of reading its output.
logger.level = 'silent';

import { Command } from '../core/Command.js';
import { HoneypotCommand } from './HoneypotCommand.js';
import { PingCommand } from './PingCommand.js';
import { HelpCommand } from './HelpCommand.js';

/**
 * Central command registry: single source of truth.
 * Add new commands here and they are registered and documented automatically.
 */
export const ALL_COMMANDS: Command[] = [
  new HoneypotCommand(),
  new PingCommand(),
  new HelpCommand()
];

export { HoneypotCommand } from './HoneypotCommand.js';
export { PingCommand } from './PingCommand.js';
export { HelpCommand } from './HelpCommand.js';

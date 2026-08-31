import { Logger } from './Logger.js';

/**
 * Environment validation. Catches a bad or missing token at startup with a clear message,
 * rather than letting it surface later as an opaque Discord error.
 */
export class Environment {
  private static logger = new Logger({ context: 'Environment' });

  private static readonly REQUIRED_VARS = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID'] as const;

  private static readonly OPTIONAL_VARS = {
    NODE_ENV: 'production',
    DEVELOPER_IDS: '',
    DATA_DIR: 'data',
    REGISTER_ON_BOOT: 'true'
  } as const;

  public static validate(): void {
    this.logger.info('validate - Validating environment variables...');

    const missing: string[] = [];
    const invalid: string[] = [];

    for (const varName of this.REQUIRED_VARS) {
      const value = process.env[varName];
      if (!value) {
        missing.push(varName);
        continue;
      }

      switch (varName) {
        case 'DISCORD_TOKEN':
          if (!this.isValidDiscordToken(value)) invalid.push(`${varName} (invalid format)`);
          break;
        case 'DISCORD_CLIENT_ID':
          if (!this.isValidDiscordId(value)) invalid.push(`${varName} (invalid format)`);
          break;
      }
    }

    for (const [varName, defaultValue] of Object.entries(this.OPTIONAL_VARS)) {
      if (!process.env[varName]) {
        process.env[varName] = defaultValue;
        this.logger.info(`validate - Set default for ${varName}: ${defaultValue}`);
      }
    }

    if (process.env.DEVELOPER_IDS) {
      for (const id of process.env.DEVELOPER_IDS.split(',').map(entry => entry.trim())) {
        if (id && !this.isValidDiscordId(id)) {
          invalid.push(`DEVELOPER_IDS contains invalid ID: ${id}`);
        }
      }
    }

    if (missing.length > 0) {
      this.logger.error(`validate - Missing required environment variables: ${missing.join(', ')}`);
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    if (invalid.length > 0) {
      this.logger.error(`validate - Invalid environment variables: ${invalid.join(', ')}`);
      throw new Error(`Invalid environment variables: ${invalid.join(', ')}`);
    }

    this.logger.info('validate - Environment validation passed');
    this.logEnvironmentInfo();
  }

  private static isValidDiscordToken(token: string): boolean {
    return token.length > 50 && token.includes('.');
  }

  /** Discord IDs are 17-20 digit snowflakes. */
  private static isValidDiscordId(id: string): boolean {
    return /^\d{17,20}$/.test(id);
  }

  private static logEnvironmentInfo(): void {
    this.logger.info(`validate - Environment: ${process.env.NODE_ENV}`);
    this.logger.info(`validate - Discord Client ID: ${process.env.DISCORD_CLIENT_ID}`);
    this.logger.info(`validate - Discord Token: ${this.maskToken(process.env.DISCORD_TOKEN!)}`);
    this.logger.info(`validate - Data directory: ${process.env.DATA_DIR}`);

    if (process.env.DEVELOPER_IDS) {
      const count = process.env.DEVELOPER_IDS.split(',').filter(id => id.trim()).length;
      this.logger.info(`validate - Developer IDs configured: ${count}`);
    }
  }

  /** Never log a whole token, not even at debug level. */
  private static maskToken(token: string): string {
    if (token.length < 10) return '***';
    return `${token.substring(0, 6)}***${token.substring(token.length - 4)}`;
  }

  public static getConfig() {
    return {
      discordToken: process.env.DISCORD_TOKEN!,
      discordClientId: process.env.DISCORD_CLIENT_ID!,
      nodeEnv: process.env.NODE_ENV!,
      dataDir: process.env.DATA_DIR || 'data',
      registerOnBoot: (process.env.REGISTER_ON_BOOT || 'true').toLowerCase() !== 'false',
      developerIds:
        process.env.DEVELOPER_IDS?.split(',')
          .map(id => id.trim())
          .filter(Boolean) || [],
      isDevelopment: process.env.NODE_ENV === 'development',
      isProduction: process.env.NODE_ENV === 'production'
    };
  }
}

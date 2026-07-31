export type NotificationAction = { label: string; value: string };

export interface INotification {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  confirm(msg: string, options: string[]): Promise<string | undefined>;
}

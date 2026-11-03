/*
 * What a host needs to talk to the surfaces, with no React in it: the VS Code
 * extension host bundles this into a CommonJS file that must not pull a UI
 * framework in, so it is an entry of its own rather than part of the index.
 */
export * from './shared/protocol';
export * from './shared/taskLogProtocol';
export * from './shared/conversationPatch';
export * from './shared/slashCommands';

/**
 * The version of the messages above. A host and its surfaces are built from
 * the same source today, so nothing checks it yet; it exists so a host that
 * ships separately from the surfaces it draws (a desktop window loading a
 * newer bundle) has one number to compare instead of guessing from the shape
 * of a message. Raise it on any change a host built against the old messages
 * would misread.
 */
export const PROTOCOL_VERSION = 1;

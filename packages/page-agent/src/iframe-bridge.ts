/**
 * Optional cross-origin iframe bridge entry point.
 *
 * Keeping this separate from the default entry prevents bridge code from
 * becoming part of applications that only use local DOM control.
 */
export { PageController } from '@page-agent/page-controller'
export type * from '@page-agent/page-controller'
export * from '@page-agent/page-controller/iframe-bridge'

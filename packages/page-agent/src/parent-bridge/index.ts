/**
 * Protocol-only parent bridge facade.
 *
 * Runtime implementations live in the explicit `/host` and `/adapter`
 * entries so importing this root facade cannot pull a DOM controller or host
 * lifecycle or a DOM controller into an application accidentally.
 */
export * from '@page-agent/page-controller/parent-bridge'

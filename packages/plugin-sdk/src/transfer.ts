/** Host-private methods; never expose these through a generic WebView RPC. */
export interface WindowTransferExport {
  readonly windowIds: readonly string[]
  readonly endpointIds: readonly number[]
  readonly includeDefault?: boolean
}

/** Plugin-owned payloads stay opaque to the host and other plugins. */
export interface WindowTransferImport {
  readonly data: unknown
  readonly windowIdMap: Readonly<Record<string, string>>
  readonly transactionId: string
}

export interface WindowTransferReceipt {
  readonly receipt: string
  readonly endpointIdMap?: Readonly<Record<string, number>>
}

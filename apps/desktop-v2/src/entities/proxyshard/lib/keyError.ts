/// Whether a failed `ps_me` means the key itself was refused, as opposed to
/// ProxyShard being out of reach (PC-127): the two ask for different fixes.
export function keyRejected(err: string): boolean {
  return /\b(401|403)\b|unauthori[sz]ed|forbidden|rejected|invalid (api )?key/i.test(err);
}

export function getTrafficUsageBytes(server) {
  const rx = parseFloat(server?.net_rx_monthly) || 0;
  const tx = parseFloat(server?.net_tx_monthly) || 0;
  const calcType = server?.traffic_calc_type || 'total';
  if (calcType === 'dl') return rx;
  if (calcType === 'ul') return tx;
  if (calcType === 'max') return Math.max(rx, tx);
  if (calcType === 'min') return Math.min(rx, tx);
  return rx + tx;
}

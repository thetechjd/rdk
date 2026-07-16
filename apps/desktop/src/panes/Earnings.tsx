import { useEffect, useState } from 'react';
import type { EarningsSummary } from '../../shared/ipc';
import { useApp } from '../store';

export function Earnings() {
  const { dataVersion } = useApp();
  const [data, setData] = useState<EarningsSummary | null>(null);

  useEffect(() => { window.rdk.getEarnings().then(setData); }, [dataVersion]);

  if (!data) return <div className="empty">loading earnings…</div>;

  const max = Math.max(1, ...data.overTime.map(d => d.usdc));

  return (
    <div className="earnings">
      <div>
        <div className="section-label">total earned</div>
        <div className="total">${data.totalUsdc.toFixed(2)}</div>
      </div>

      {data.overTime.length > 0 && (
        <div>
          <div className="section-label" style={{ marginBottom: 10 }}>over time</div>
          <div className="bars">
            {data.overTime.map((d, i) => (
              <div key={i} className="bar" style={{ height: `${(d.usdc / max) * 100}%` }} title={`${d.date}: $${d.usdc.toFixed(2)}`} />
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="section-label" style={{ marginBottom: 6 }}>by document</div>
        {data.byDocument.length === 0 && <div className="hint">No earning documents yet. Publish public chunks to start earning tips when the network retrieves them.</div>}
        {data.byDocument.map(d => (
          <div key={d.chunkId} className="doc-row">
            <span>{d.title}</span>
            <span><span style={{ color: 'var(--muted)' }}>{d.retrievals} retrievals</span> &nbsp; <span className="earn">${d.earnedUsdc.toFixed(2)}</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}

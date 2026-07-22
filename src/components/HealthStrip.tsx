interface Props {
  status: string; received: number | null; persisted: number | null; malformed: number | null; dropped: number | null;
  queueDepth: number | null; throughput: string | null; drift: string | null; reconnects: number | null; lastEventAge: string | null; sessionPath: string | null;
}

export default function HealthStrip(props: Props) {
  const state = (props.dropped ?? 0) > 0 || (props.malformed ?? 0) > 0 ? "degraded" : props.status;
  const metric = (label: string, value: string | number | null, className = "") => {
    const displayValue = value ?? "—";
    return <div className="health-metric" aria-label={`${label}: ${value === null ? "not reported" : value}`}><small>{label}</small><strong className={className}>{displayValue}</strong></div>;
  };
  return (
    <footer className="health-strip" aria-label="Capture health">
      <div className={`health-state state-${state}`}><i />{state.toUpperCase()}</div>
      {metric("RECEIVED", props.received)}
      {metric("PERSISTED", props.persisted)}
      {metric("MALFORMED", props.malformed, props.malformed ? "warning-text" : "")}
      {metric("DROPPED", props.dropped, props.dropped ? "danger-text" : "")}
      {metric("QUEUE", props.queueDepth)}
      {metric("THROUGHPUT", props.throughput)}
      {metric("DRIFT", props.drift)}
      {metric("RECONNECTS", props.reconnects === null ? null : `${props.reconnects} reconnect${props.reconnects === 1 ? "" : "s"}`)}
      {metric("LAST EVENT", props.lastEventAge)}
      <div className="health-session" title={props.sessionPath ?? "No session"}><small>SESSION</small><strong>{props.sessionPath ?? "No session"}</strong></div>
    </footer>
  );
}

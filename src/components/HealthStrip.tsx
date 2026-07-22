interface Props {
  status: string; received: number; persisted: number; malformed: number; dropped: number;
  queueDepth: number; throughput: string; drift: string; reconnects: number; lastEventAge: string; sessionPath: string | null;
}

export default function HealthStrip(props: Props) {
  const state = props.dropped > 0 || props.malformed > 0 ? "degraded" : props.status;
  const metric = (label: string, value: string | number, className = "") => <div className="health-metric"><small>{label}</small><strong className={className}>{value}</strong></div>;
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
      {metric("RECONNECTS", `${props.reconnects} reconnect`)}
      {metric("LAST EVENT", props.lastEventAge)}
      <div className="health-session" title={props.sessionPath ?? "No session"}><small>SESSION</small><strong>{props.sessionPath ?? "No session"}</strong></div>
    </footer>
  );
}

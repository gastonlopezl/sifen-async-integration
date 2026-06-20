export default function Home() {
  return (
    <main>
      <h1>SIFEN async integration</h1>
      <p>
        Paraguay electronic invoicing over SET&apos;s async lote web service. The
        API surface is two routes:
      </p>
      <ul>
        <li>
          <code>POST /api/documents/enqueue</code> builds, signs, and queues a DE,
          returns its CDC.
        </li>
        <li>
          <code>GET /api/documents/status?cdc=...</code> reads the current SIFEN
          status of a document.
        </li>
      </ul>
      <p>
        The dispatch and poll loops run in the worker process (<code>npm run worker</code>),
        which must run from a static, known-good egress that SET accepts. Read the README.
      </p>
    </main>
  );
}

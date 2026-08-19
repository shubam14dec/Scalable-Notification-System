// Pretend "Acme backend" for the demo refund_customer tool: receives the
// platform's signed POST and refunds enthusiastically. Demo-only — a real
// integration would verify x-asyncify-signature first (see docs/AGENT-TOOLS.md).
import http from 'node:http';

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let args = {};
      try {
        args = JSON.parse(body).args ?? {};
      } catch {
        /* demo: tolerate any shape */
      }
      const reply = {
        status: 'refunded',
        refundId: `R-${Date.now()}`,
        orderId: args.orderId ?? null,
        eta: '3-5 business days',
      };
      console.log(`[acme-tools] ${req.url} ->`, reply);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  })
  .listen(4400, () => console.log('acme demo tool backend on http://localhost:4400'));

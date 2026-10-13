# Multi-Session Production Incident Synthesis (WebSockets + Railway)

## sess-1
**USER**: Post-mortem note: WebSocket connections behind Cloudflare proxy drop after 100s idle; requires 45-second keepalive ping/pong.

## sess-2
**USER**: Deployment incident: Railway private networking requires binding the server process to IPv6 loopback `::` rather than 0.0.0.0.


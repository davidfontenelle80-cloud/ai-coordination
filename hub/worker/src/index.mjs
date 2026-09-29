// index.mjs — Worker entry point (task 007 scaffold).
//
// NOTE: HTTP command handlers land in task 009. This placeholder exists so
// the Worker project structure is complete; it is NOT deployed in this phase.

export default {
  async fetch() {
    return new Response(
      JSON.stringify({ error: 'not implemented: command handlers land in task 009' }),
      { status: 501, headers: { 'content-type': 'application/json' } },
    );
  },
};

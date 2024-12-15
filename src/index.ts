import { buildData } from './lib/fosdem';

const run = async (env: any) => {
	const year = '2025';
  const data = await buildData({ year });

	await env.R2.put(`fosdem-${year}.json`, JSON.stringify(data, null, 2));

  console.log('Data uploaded');
};

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return new Response('Hello World!');
	},
  async scheduled(event: any, env: any, ctx: any) {
    ctx.waitUntil(run(env));
  },
} satisfies ExportedHandler<Env>;

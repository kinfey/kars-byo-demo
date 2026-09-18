import { command } from '../server/docker.mjs';
import { RUNTIMES } from '../server/config.mjs';
for (const runtime of Object.values(RUNTIMES)) {
  console.log(`Building ${runtime.image}`);
  await command(['build', '--build-arg', `RUNTIME=${runtime.id}`, '-t', runtime.image, '-f', 'containers/Dockerfile', '.'], {
    onData: text => process.stdout.write(text), timeout: 1800000,
  });
}

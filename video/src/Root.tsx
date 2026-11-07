import { Composition } from 'remotion';
import { Desenrola, TOTAL } from './Desenrola';

export const Root = () => (
  <Composition id="Desenrola" component={Desenrola} durationInFrames={TOTAL} fps={30} width={1920} height={1080} />
);

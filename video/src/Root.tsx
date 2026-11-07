import { Composition } from 'remotion';
import { Resolvedor, TOTAL } from './Resolvedor';

export const Root = () => (
  <Composition id="Resolvedor" component={Resolvedor} durationInFrames={TOTAL} fps={30} width={1920} height={1080} />
);

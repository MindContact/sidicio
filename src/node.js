// Main-thread side: loads the worklet into an AudioContext and returns the
// node, connected to nothing. Talk to it with `node.port.postMessage` (the
// messages are listed in worklet.js).

export async function createSidicioNode(ctx) {
  await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
  return new AudioWorkletNode(ctx, 'sidicio', {
    numberOfInputs: 0,
    outputChannelCount: [2],
  });
}

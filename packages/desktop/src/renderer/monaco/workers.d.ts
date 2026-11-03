// Vite's `?worker` import: a bundled worker file served from the app's own origin.
declare module '*?worker' {
  const WorkerClass: new () => Worker;
  export default WorkerClass;
}

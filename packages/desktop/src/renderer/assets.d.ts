// Vite turns an imported image into the URL of its copy in the build (assetsInlineLimit: 0).
declare module '*.png' {
  const url: string;
  export default url;
}

/** The release build's licensing configuration (docs/DEPLOYMENT.md); empty in a developer build. */
interface ImportMetaEnv {
  readonly MAIN_VITE_SITE_URL?: string;
  readonly MAIN_VITE_LICENSE_PUBLIC_KEY?: string;
  /** Where "Send to VC Film Studio" posts the day; vcfilmstudio.com when unset. */
  readonly MAIN_VITE_FILM_STUDIO_URL?: string;
}

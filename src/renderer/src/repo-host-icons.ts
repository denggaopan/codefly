import type { RepoHost } from '../../shared/contracts'
import gitIconUrl from './assets/git.svg'
import githubIconUrl from './assets/github.svg'
import gitlabIconUrl from './assets/gitlab.svg'

type RepoHostIcon = { url: string; className: string }

// GitHub's mark is a single-color glyph (its official form), so it is drawn black and
// inverted for the dark theme like the other mono icons; GitLab and Git keep their brand
// colors, which read on both themes.
const icons: Readonly<Record<RepoHost, RepoHostIcon>> = {
  github: { url: githubIconUrl, className: 'icon icon-repo icon-mono' },
  gitlab: { url: gitlabIconUrl, className: 'icon icon-repo' },
  git: { url: gitIconUrl, className: 'icon icon-repo' }
}

/** Icon for the "Open Git repository" entry, chosen by where the project's remote is hosted. */
export const repoHostIcon = (host: RepoHost): RepoHostIcon => icons[host]

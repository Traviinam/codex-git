# Contributing

## Branch flow

`dev` is the default integration branch. Open feature, fix, documentation, and maintenance pull requests against `dev`.

`main` is the release branch. A pull request may target `main` only when its source branch is `dev`; merging that pull request is the release event.

```text
feature/fix/docs branch → dev → main
                          work   release
```

Do not target `main` directly from a topic branch. The release-source workflow automatically explains and closes pull requests that violate this rule.

# Security Policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue or pull
request.

Use GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**. That opens a report
only the maintainer can see.

A useful report says what you found, how to reproduce it, and what an attacker
could do with it. A proof of concept helps, but please do not test against a
deployment you do not own, and do not access, change, or keep other people's
data.

You should get an acknowledgement within a week. Once a fix is released, the
report is credited to you unless you would rather it were not.

## Supported versions

Bartelby does not publish versioned releases yet. Fixes are made on the `main`
branch only, so run a current `main`.

## Scope

In scope: this repository's application code, its default configuration, and
the `Dockerfile` and `docker-compose.yml` it ships.

`docker-compose.yml` is a single-machine setup for local use and evaluation. It
keeps sessions in process memory and gives its bundled object store default
credentials, published on loopback only. That is intended; see
[DEPLOY.md](./DEPLOY.md) for a production topology.

Known dependency advisories, and why each is not reachable in a production
deployment, are listed in [DEPLOY.md](./DEPLOY.md) under "Known open
advisories". A report about one of those needs to show that the documented
mitigation does not hold.

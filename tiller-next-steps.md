# Tiller Architecture

## Workspaces

Currently Tiller uses a container. This is great for some kinds of tasks, and we simply use Claude Code directly and get the benifit of all the updates it gets. The container options we have used are Fly.io sprites + juice or cloudflare containers. They both have pros and cons.

Sometimes you don't need an entire container however. In that case we use cloudflare dynamic workers. These are not linux environments, and can't run claude code

## Interacting

Through a computer you interact via a CLI which boots into your remote environments. Through the phone we still provide a way to type this in, but it's janky. Via the phone it is expected that you'll interact with voice.

## Future Work

- If we want to add a "light tier", then we need to add "@cloudflare/shell" so that the files can be shared between the two.

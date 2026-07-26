.PHONY: run test lint install build

run:
	./bin/liveclaudecode --open

test:
	pnpm test

lint:
	pnpm test:types

install:
	pnpm install

build:
	pnpm build

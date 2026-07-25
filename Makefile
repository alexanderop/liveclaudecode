.PHONY: run test lint install

run:
	python3 -m liveclaudecode --open

test:
	python3 -m unittest discover -s tests -t .

lint:
	python3 -m compileall -q liveclaudecode tests

install:
	pip install -e .

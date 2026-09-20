#!/usr/bin/env python3
"""Print the complete HTTP matrix as Markdown, including RSS, PSS, and startup."""
import argparse
import json
import statistics
from pathlib import Path


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('result')
parser.add_argument('--startup-result', help='optional startup-only matrix result')
args = parser.parse_args()
result = json.loads(Path(args.result).read_text())
if not result.get('complete'):
    raise SystemExit(f'incomplete result: {result.get("error", "no recorded error")}')


def mean(values):
    return statistics.fmean(values) if values else None


def integer(value):
    return '—' if value is None else f'{value:,.0f}'


def memory(value):
    return '—' if value is None else f'{value / 1024:.1f}'


servers = result['settings']['servers']
workers = result['settings']['workers']
samples = result['samples']
startup_result = (json.loads(Path(args.startup_result).read_text())
                  if args.startup_result else result)
if not startup_result.get('complete'):
    raise SystemExit(f'incomplete startup result: {startup_result.get("error", "no recorded error")}')
startups = startup_result.get('startups', [])

columns = ['Server']
for worker_count in workers:
    label = 'Single' if worker_count == 1 else f'{worker_count} workers'
    columns.extend((f'{label} `/`', f'{label} `/json`', f'{label} RSS MiB',
                    f'{label} PSS MiB', f'{label} startup ms'))
print('| ' + ' | '.join(columns) + ' |')
print('| --- |' + ' ---: |' * (len(columns) - 1))
for server in servers:
    cells = [server]
    for worker_count in workers:
        selected = [row for row in samples
                    if row['server'] == server and row['workers'] == worker_count]
        for path in ('/', '/json'):
            cells.append(integer(mean([row['rps'] for row in selected if row['path'] == path])))
        rss = max((memory_row['rss_kib']
                   for row in selected
                   for memory_row in (row['memory_before'], row['memory_after'])), default=None)
        pss = max((memory_row['pss_kib']
                   for row in selected
                   for memory_row in (row['memory_before'], row['memory_after'])), default=None)
        cells.append(memory(rss))
        cells.append(memory(pss))
        cells.append(integer(mean([
            row['milliseconds'] for row in startups
            if row['server'] == server and row['workers'] == worker_count
        ])))
    print('| ' + ' | '.join(cells) + ' |')

wire = result.get('wire_contract', [])
if wire:
    sizes = sorted({(row['path'], row['bytes']) for row in wire})
    print(f'\nWire contract checks: {len(wire)} passed; sizes: {sizes}.')

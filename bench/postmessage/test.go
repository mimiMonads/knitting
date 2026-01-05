package main

import (
	"fmt"
	"math"
	"sort"
	"sync"
	"time"
)

// Task represents a range [Start, End] whose primes will be computed.
type Task struct {
	Start, End int
	// result Ch to send back the found primes
	ResultCh chan<- []int
}

// ThreadPool manages a fixed number of worker goroutines.
type ThreadPool struct {
	threads   int
	tasks     chan Task
	waitGroup sync.WaitGroup
}

// NewThreadPool creates a pool with n workers.
// The tasks channel is buffered so you can enqueue before starting.
func NewThreadPool(n, maxPending int) *ThreadPool {
	return &ThreadPool{
		threads: n,
		tasks:   make(chan Task, maxPending),
	}
}

// Start spins up the worker goroutines.
// Call this once after you've enqueued all your tasks (or even before; it's safe).
func (p *ThreadPool) Start() {
	for i := 0; i < p.threads; i++ {
		p.waitGroup.Add(1)
		go func(id int) {
			defer p.waitGroup.Done()
			for task := range p.tasks {
				task.ResultCh <- findPrimes(task.Start, task.End)
			}
		}(i)
	}
}

// Submit enqueues one job [start,end] and returns a channel on which the result will be sent.
func (p *ThreadPool) Submit(start, end int) <-chan []int {
	resCh := make(chan []int, 1)
	p.tasks <- Task{Start: start, End: end, ResultCh: resCh}
	return resCh
}

// Close tells the pool no more tasks are coming; workers will exit once the queue drains.
func (p *ThreadPool) Close() {
	close(p.tasks)
}

// Wait waits for all workers to finish (after Close).
func (p *ThreadPool) Wait() {
	p.waitGroup.Wait()
}

// FastCall is like fastCall: runs the prime finder directly.
func FastCall(start, end int) []int {
	return findPrimes(start, end)
}

func findPrimes(start, end int) []int {
    if end < 2 {
        return nil
    }
    primes := []int{}
    // handle 2 explicitly, then only test odds
    if start <= 2 {
        primes = append(primes, 2)
    }
    if start%2 == 0 {
        start++  // make start odd
    }
    for n := start; n <= end; n += 2 {
        isP := true
        limit := int(math.Sqrt(float64(n)))
        for d := 3; d <= limit; d += 2 {
            if n%d == 0 {
                isP = false
                break
            }
        }
        if isP {
            primes = append(primes, n)
        }
    }
    return primes
}

func main() {
	const (
		Limit  = 10_000_000
		Chunk  = 100_000
		Threads = 6
	)

	startTime := time.Now()

	// Create a pool with enough buffer to hold all tasks if you like.
	pool := NewThreadPool(Threads, Limit/Chunk+1)

	// Enqueue all of the chunks before starting the workers.
	var resultChans []<-chan []int
	for start := 2; start <= Limit; start += Chunk {
		end := start + Chunk - 1
		if end > Limit {
			end = Limit
		}
		resultChans = append(resultChans, pool.Submit(start, end))
	}

	
	pool.Start()

	// No more tasks.
	pool.Close()

	// Collect and merge results.
	allPrimes := make([]int, 0, Limit/10)
	for _, ch := range resultChans {
		chunkPrimes := <-ch
		allPrimes = append(allPrimes, chunkPrimes...)
	}

	// Wait for workers to exit cleanly.
	pool.Wait()
	

	sort.Ints(allPrimes)

	elapsed := time.Since(startTime)

	fmt.Printf("Found %d primes ≤ %d\n", len(allPrimes), Limit)
	fmt.Printf("Largest prime: %d\n", allPrimes[len(allPrimes)-1])
	fmt.Printf("Time taken: %v\n\n", elapsed)


}

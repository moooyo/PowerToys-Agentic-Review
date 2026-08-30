package main

import "testing"

func TestValidMaximumConcurrentRequests(t *testing.T) {
	for _, value := range []int{minimumConcurrentRequests, 4, maximumConcurrentRequests} {
		if !validMaximumConcurrentRequests(value) {
			t.Fatalf("value %d should be valid", value)
		}
	}
	for _, value := range []int{minimumConcurrentRequests - 1, maximumConcurrentRequests + 1} {
		if validMaximumConcurrentRequests(value) {
			t.Fatalf("value %d should be invalid", value)
		}
	}
}

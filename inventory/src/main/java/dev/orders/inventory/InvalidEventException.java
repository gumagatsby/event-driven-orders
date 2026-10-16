package dev.orders.inventory;

/** A message that can never be processed. It goes to the dead-letter topic instead of being retried. */
public class InvalidEventException extends RuntimeException {

	public InvalidEventException(String message) {
		super(message);
	}

	public InvalidEventException(String message, Throwable cause) {
		super(message, cause);
	}

}

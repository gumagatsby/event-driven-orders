package dev.orders.inventory;

import java.util.ArrayList;
import java.util.List;

import dev.orders.inventory.grpc.InventoryGrpcService;
import dev.orders.inventory.grpc.v1.CheckAvailabilityRequest;
import dev.orders.inventory.grpc.v1.CheckAvailabilityResponse;
import dev.orders.inventory.grpc.v1.Line;
import dev.orders.inventory.grpc.v1.ListProductsRequest;
import dev.orders.inventory.grpc.v1.ListProductsResponse;
import io.grpc.Status;
import io.grpc.stub.StreamObserver;
import org.junit.jupiter.api.Test;

import org.springframework.beans.factory.annotation.Autowired;

import static org.assertj.core.api.Assertions.assertThat;

class GrpcServiceTest extends IntegrationTest {

	@Autowired
	InventoryGrpcService grpc;

	static class Recorder<T> implements StreamObserver<T> {

		final List<T> values = new ArrayList<>();

		Throwable error;

		@Override
		public void onNext(T value) {
			this.values.add(value);
		}

		@Override
		public void onError(Throwable t) {
			this.error = t;
		}

		@Override
		public void onCompleted() {
		}

	}

	@Test
	void listsTheCatalogueWithAvailableStock() {
		Recorder<ListProductsResponse> out = new Recorder<>();
		this.grpc.listProducts(ListProductsRequest.getDefaultInstance(), out);
		assertThat(out.values.getFirst().getProductsList()).hasSize(5);
		assertThat(out.values.getFirst().getProducts(0).getSku()).isEqualTo("CB-005");
	}

	@Test
	void reportsWhichLinesAreShort() {
		Recorder<CheckAvailabilityResponse> out = new Recorder<>();
		this.grpc.checkAvailability(CheckAvailabilityRequest.newBuilder()
			.addLines(Line.newBuilder().setSku("KB-001").setQuantity(1))
			.addLines(Line.newBuilder().setSku("MN-003").setQuantity(11))
			.addLines(Line.newBuilder().setSku("NOPE-1").setQuantity(1))
			.build(), out);
		CheckAvailabilityResponse r = out.values.getFirst();
		assertThat(r.getAllAvailable()).isFalse();
		assertThat(r.getLinesList()).extracting(l -> l.getSku() + ":" + l.getSufficient() + ":" + l.getKnown())
			.containsExactly("KB-001:true:true", "MN-003:false:true", "NOPE-1:false:false");
	}

	@Test
	void rejectsAnEmptyRequest() {
		Recorder<CheckAvailabilityResponse> out = new Recorder<>();
		this.grpc.checkAvailability(CheckAvailabilityRequest.getDefaultInstance(), out);
		assertThat(Status.fromThrowable(out.error).getCode()).isEqualTo(Status.Code.INVALID_ARGUMENT);
	}

}

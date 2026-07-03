import torch


if torch.cuda.is_available():
    print("CUDA is available. Using GPU for inference.")
else:
    print("CUDA is not available. Using CPU for inference.")    
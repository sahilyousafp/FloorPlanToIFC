# FloorPlanTo3D: The Next Dimension in Architectural Visualization

## Introduction

FloorPlanTo3D introduces an innovative approach to transform 2D floor plan images into customizable 3D models. The process begins with users selecting a floor plan image, which is then sent to a deep learning model for analysis. Subsequently, users have the ability to customize the generated 3D scene according to their preferences.
![2D Floor Plan to 3D Model Conversion - Example a](./images/example1.png) ![2D Floor Plan to 3D Model Conversion - Example b](./images/example2.png) ![2D Floor Plan with Hand Drawn Parts to 3D Model Conversion](./images/handDrawn.png)

FloorPlanTo3D showcases the robust capability to detect and interpret floor plans with different drawing styles, including those with hand-drawn elements.

## Project Components

FloorPlanTo3D is structured into two main parts:

1.  **Mask R-CNN Model Wrapped by REST API**: A sophisticated deep learning model that analyzes and interprets 2D floor plan images.

2.  **Unity Application**: A dynamic application that utilizes the API to construct a 3D scene from the analyzed 2D floor plan images, enabling users to customize their virtual environment.

## Installation

To set up and run the project, follow these steps:

1.  **Clone this repo**:

```
git clone https://github.com/fadyazizz/FloorPlanTo3D-API
cd FloorPlanTo3D-API

```

2.  **Create and activate a new conda environment**:

```

conda create --name imageTo3D python=3.6.13

conda activate imageTo3D

```

3.  **Install dependencies**:

```


pip install -r requirements.txt

```

4.  **Download the deep learning model weights** from the following link and insert them into the `weights` folder:

[Deep Learning Model Weights](https://drive.google.com/file/d/14fDV0b_sKDg0_DkQBTyO1UaT6mHrW9es/view?usp=sharing)

5.  **Start the server**:

```

python application.py

```

## Browser Viewer

With the server running, open [http://127.0.0.1:5000/](http://127.0.0.1:5000/) to use the built-in Three.js viewer. Choose or drop a floor plan image and press **Detect** to see the detected walls, doors and windows extruded in 3D, or switch to the top view to check them against the plan. You can filter by class and confidence (down to 0.5) and change the wall height. Hover an element to see its class, score and pixel coordinates.

Each element is drawn as a rectangle fitted to its Mask R-CNN mask, so diagonal walls come out rotated. Doors and windows take the direction and thickness of the wall they sit in. Detected walls usually stop short of an opening, so, as in the Unity client, the gap between an opening and the next wall is closed with a wall piece (shown as "gap fill").

**Rooms** are found from the geometry, since the model has no room class: every region enclosed by walls, gap fills and openings becomes a room, shown as a floor tint with its area. Short gaps at wall ends (up to 1.2 m) also count as room boundaries, so undetected doorways don't merge rooms. Rooms that leak through missing walls are left out.

**Download IFC4** saves what is shown as an IFC4 file (`IfcWall`, `IfcDoor`, `IfcWindow` in a site, building and storey hierarchy, in meters). Doors and windows that overlap a wall cut an `IfcOpeningElement` into it. Rooms are written as `IfcSpace` (named `Space 1`, `Space 2`, ... in reading order), aggregated under the storey, with `Qto_SpaceBaseQuantities` (`NetFloorArea`, `Height`). Each wall, door and window carries a `FloorPlanTo3D_Detection` property set with `IsGapFill`, plus its confidence and pixel bounding box when it was detected.

The viewer lives in `static/` and needs no build step.

### API response

`POST /` with an `image` form file returns parallel arrays, one entry per detection:

- `points`: `{x1, y1, x2, y2}`, the axis-aligned bounding box of the mask in pixels
- `classes`: `{name}`, one of `wall`, `door`, `window`
- `scores`: confidence from 0.5 to 1
- `shapes`: `{cx, cy, length, thickness, angle}`, the rectangle fitted to the mask in pixels; `angle` is the direction of the long side in degrees from +x, with image y pointing down, snapped to 0 or 90 when within 3 degrees

plus `Width`, `Height` (image size) and `averageDoor` (mean door size in pixels, used for scale). The Unity client reads only `points`, `classes` and `averageDoor`.

These steps will prepare your environment for using the API. While the API can be accessed with any client, for a fully integrated experience, we recommend using our Unity application, located in the Unity directory (Unity engine installation required).

## Customization Features, download from this link [Our Unity Client](https://github.com/fadyazizz/FloorPlanTo3D-unityClient)

Users are afforded a wide range of customization options for their 3D models, including but not limited to:

- Snap an image and send to the api to be analyzed
- Modifying the scale to ensure the model matches real-world dimensions.

  <div style="display: flex; align-items: center; justify-content: space-around;">
    <img src="./images/scale2.png" width="500" height="250 alt="Alt text for first image">
    <img src="./images/scale1.png" width="500" height="250 alt="Alt text for second image">
</div>

- Changing the colors and textures of walls.
 <div style="display: flex; align-items: center; justify-content: space-around;">
    <img src="./images/wall1.png" width="500" height="250 alt="Alt text for first image">
    <img src="./images/wall2.png" width="500" height="250 alt="Alt text for second image">
</div>

- Adding furniture and selecting different styles for doors and windows.
<div style="display: flex; align-items: center; justify-content: space-around;">
   <img src="./images/furniture.png" width="500" height="250 alt="Alt text for first image">

</div>

- Have a virtual tour inside the 3D generated floor plan.

## Model Used

FloorPlanTo3D employs the Mask R-CNN model, renowned for its accuracy in object detection and instance segmentation. Our implementation is based on the Matterport version, which is specifically adapted to analyze floor plans effectively. For further details on the Mask R-CNN model, visit the [Mask R-CNN GitHub Repository](https://github.com/matterport/Mask_RCNN).

## Model Training

The model training process involved the following key steps:

- **Data set management**: Utilized a split of 80% training and 20% testing from the Cubicasa5K dataset, which contains 5000 floor plans with diverse drawing styles and is available at [Cubicasa5K Dataset](https://zenodo.org/record/2613548).

- **Model configuration**: Employed Resnet101 as the backbone, with transfer learning from the MS COCO dataset to enhance training efficiency.

- **Training**: Conducted over 15 epochs with a batch size of 1, completed in approximately 40 hours, to detect three classes of objects: walls, windows, and doors.

For an in-depth exploration of the project, refer to the bachelor's thesis available at: [Bachelor Thesis Link](https://drive.google.com/file/d/11xyyv_jUtbEp0WM-ymfffnzX45ryDV0X/view?usp=sharing).

## Author

Fady Aziz Ibrahim

Email: fady.aziz.ibrahim@gmail.com

LinkedIn: [Fady Aziz](https://www.linkedin.com/in/fady-aziz-b40687163/)
